import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { honeytar } from '../src/handler.js';
import { resetRateLimit } from '../src/report.js';

const env = { HONEYTAR_URL: 'https://hp.example.test/fn', HONEYTAR_SECRET: 'x'.repeat(32) };
const req = (path: string) => new Request(`https://site.example${path}`, { headers: { 'cf-connecting-ip': '198.51.100.7' } });

beforeEach(() => resetRateLimit());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('honeytar()', () => {
  it('returns null for ordinary paths, so the Worker carries on', async () => {
    const f = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', f);
    expect(await honeytar(req('/'), env)).toBeNull();
    expect(await honeytar(req('/blog/post'), env)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('serves a decoy and reports the visit without waiting for the report', async () => {
    const f = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', f);
    const waits: Promise<unknown>[] = [];
    const res = await honeytar(req('/wp-login.php'), env, { waitUntil: (p) => void waits.push(p) });
    expect(res!.status).toBe(200);
    expect(await res!.text()).toContain('name="pwd"');
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('works with no execution context', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    expect((await honeytar(req('/.env'), env))!.status).toBe(200);
  });

  it('holds the decoy when the tarpit is on, and tells keepAlive so the report can finish', async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn(async () => new Response('{}'));
      vi.stubGlobal('fetch', f);
      const waits: Promise<unknown>[] = [];
      const res = await honeytar(req('/.env'), { ...env, HONEYTAR_TARPIT_MS: '2000' }, { waitUntil: (p) => void waits.push(p) });
      expect(waits).toHaveLength(2); // the hit report, and the hold that is still running
      const text = res!.text();
      await vi.advanceTimersByTimeAsync(2001);
      expect(await text).toContain('DB_PASSWORD');
      await Promise.all(waits);
      expect(f).toHaveBeenCalledTimes(2); // the hit, then how the hold ended
      expect(JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toMatchObject({ kind: 'hold', outcome: 'completed', heldMs: 2000 });
    } finally {
      vi.useRealTimers();
    }
  });
});
