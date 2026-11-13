import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TARPIT, tarpit, tarpitActiveCount, tarpitMs } from '../src/tarpit.js';

describe('tarpit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is off unless a hold is set, accepts the older name, and is capped', () => {
    expect(tarpitMs({})).toBe(0);
    for (const v of ['0', 'abc', '-5']) expect(tarpitMs({ HONEYTAR_TARPIT_MS: v })).toBe(0);
    expect(tarpitMs({ HONEYTAR_TARPIT_MS: '30000' })).toBe(30000);
    expect(tarpitMs({ TARPIT_MS: '8000' })).toBe(8000);
    expect(tarpitMs({ HONEYTAR_TARPIT_MS: '9999999' })).toBe(TARPIT.maxMs);
  });

  it('returns the response untouched when off', async () => {
    const res = new Response('hello');
    expect(await tarpit(res, {})).toBe(res);
  });

  it('sends headers at once and the same body after the hold', async () => {
    const res = await tarpit(new Response('APP_ENV=production\n', { status: 200, headers: { 'Content-Type': 'text/plain', 'Content-Length': '19' } }), { HONEYTAR_TARPIT_MS: '5000' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.has('content-length')).toBe(false);
    expect(tarpitActiveCount()).toBe(1);
    const text = res.text();
    await vi.advanceTimersByTimeAsync(4999);
    expect(tarpitActiveCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(await text).toBe('APP_ENV=production\n');
    expect(tarpitActiveCount()).toBe(0);
  });

  it('stops holding once the instance is full, so a flood cannot pile up connections', async () => {
    const held = await Promise.all(Array.from({ length: TARPIT.maxActive }, () => tarpit(new Response('x'), { HONEYTAR_TARPIT_MS: '1000' })));
    const overflow = new Response('y');
    expect(await tarpit(overflow, { HONEYTAR_TARPIT_MS: '1000' })).toBe(overflow);
    await Promise.all(held.map((r) => { const t = r.text(); return vi.advanceTimersByTimeAsync(1001).then(() => t); }));
    expect(tarpitActiveCount()).toBe(0);
  });

  it('reports "completed" with the hold time when the scanner waits, and calls keepAlive once', async () => {
    const results: unknown[] = [];
    let kept: Promise<unknown> | null = null;
    const res = await tarpit(new Response('x'), { HONEYTAR_TARPIT_MS: '3000' }, { onDone: (r) => { results.push(r); }, keepAlive: (p) => { kept = p; } });
    expect(kept).not.toBeNull();
    const text = res.text();
    await vi.advanceTimersByTimeAsync(3001);
    await text;
    await kept;
    expect(results).toEqual([{ heldMs: 3000, outcome: 'completed' }]);
    expect(tarpitActiveCount()).toBe(0);
  });

  it('reports "gave_up" and frees the slot at once when the scanner hangs up', async () => {
    const results: Array<{ heldMs: number; outcome: string }> = [];
    const res = await tarpit(new Response('x'), { HONEYTAR_TARPIT_MS: '30000' }, { onDone: (r) => { results.push(r); } });
    expect(tarpitActiveCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4000);
    await res.body!.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe('gave_up');
    expect(results[0]!.heldMs).toBeGreaterThanOrEqual(4000);
    expect(results[0]!.heldMs).toBeLessThan(30000);
    expect(tarpitActiveCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(40000);
    expect(results).toHaveLength(1);
  });

  it('calls no hooks when it does not hold, and survives a failing report', async () => {
    const onDone = vi.fn();
    const keepAlive = vi.fn();
    await tarpit(new Response('x'), {}, { onDone, keepAlive });
    expect(onDone).not.toHaveBeenCalled();
    expect(keepAlive).not.toHaveBeenCalled();
    const res = await tarpit(new Response('x'), { HONEYTAR_TARPIT_MS: '1000' }, { onDone: () => { throw new Error('boom'); } });
    const text = res.text();
    await vi.advanceTimersByTimeAsync(1001);
    expect(await text).toBe('x');
  });
});
