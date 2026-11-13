import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowHoldReport, allowReport, readBodySample, reportHit, reportHold, resetRateLimit } from '../src/report.js';
import type { HoneytarEnv } from '../src/settings.js';

const env = (over: HoneytarEnv = {}): HoneytarEnv => ({ HONEYTAR_URL: 'https://hp.example.test/fn', HONEYTAR_SECRET: 'x'.repeat(32), ...over });
const req = (path: string, init: RequestInit & { cfip?: string | null } = {}) => {
  const { cfip, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (cfip !== null) headers.set('cf-connecting-ip', cfip ?? '198.51.100.7');
  headers.set('cf-ipcountry', 'RU');
  return new Request(`https://site.example${path}`, { ...rest, headers });
};

beforeEach(() => resetRateLimit());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('reportHit', () => {
  it('posts one record with the secret, the source and what was sent, and drops cookies', async () => {
    const f = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', f);
    await reportHit(req('/wp-login.php?x=1', { method: 'POST', body: 'log=admin&pwd=hunter2', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'bot/1.0', cookie: 'secret' } }), env());
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hp.example.test/fn');
    expect((init.headers as Record<string, string>)['x-honeytar-secret']).toBe('x'.repeat(32));
    const payload = JSON.parse(String(init.body));
    expect(payload).toMatchObject({ ip: '198.51.100.7', country: 'RU', host: 'site.example', path: '/wp-login.php', method: 'POST', userAgent: 'bot/1.0', query: '?x=1', body: 'log=admin&pwd=hunter2' });
    expect(payload.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
  });
  it('works with the older setting names', async () => {
    const f = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', f);
    await reportHit(req('/.env'), { HONEYPOT_URL: 'https://old.example.test/fn', HONEYPOT_SECRET: 'o'.repeat(32) });
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('https://old.example.test/fn');
  });
  it('also sends what Cloudflare knows about the connection, and which Worker made the request', async () => {
    const f = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', f);
    const r = req('/.env', { headers: { 'cf-worker': 'some-zone.example' } });
    Object.defineProperty(r, 'cf', { value: { asn: 14061, asOrganization: 'DigitalOcean, LLC', city: 'Amsterdam', region: 'North Holland', colo: 'AMS', httpProtocol: 'HTTP/1.1', tlsVersion: 'TLSv1.2' } });
    await reportHit(r, env());
    const payload = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(payload).toMatchObject({ asn: '14061', asOrg: 'DigitalOcean, LLC', city: 'Amsterdam', region: 'North Holland', colo: 'AMS', httpProtocol: 'HTTP/1.1', tlsVersion: 'TLSv1.2', viaWorker: 'some-zone.example' });
  });
  it('does nothing when it is not configured, when there is no source address, or after the rate limit', async () => {
    const f = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', f);
    await reportHit(req('/.env'), env({ HONEYTAR_SECRET: undefined }));
    await reportHit(req('/.env'), env({ HONEYTAR_URL: undefined }));
    await reportHit(req('/.env', { cfip: null }), env());
    expect(f).not.toHaveBeenCalled();
    for (let i = 0; i < 40; i++) await reportHit(req('/.env'), env(), 1_000_000);
    expect(f).toHaveBeenCalledTimes(30);
  });
  it('never throws, even when the report fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(reportHit(req('/.env'), env())).resolves.toBeUndefined();
  });
});

describe('rate limits and body sampling', () => {
  it('resets the hit count each minute', () => {
    for (let i = 0; i < 30; i++) expect(allowReport(5_000_000)).toBe(true);
    expect(allowReport(5_000_001)).toBe(false);
    expect(allowReport(5_000_000 + 60_000)).toBe(true);
  });
  it('counts hold reports apart from hit reports', () => {
    for (let i = 0; i < 30; i++) expect(allowHoldReport(7_000_000)).toBe(true);
    expect(allowHoldReport(7_000_001)).toBe(false);
    expect(allowReport(7_000_001)).toBe(true);
  });
  it('reads only the start of a big body, and nothing for a GET', async () => {
    const sample = await readBodySample(new Request('https://x.test/', { method: 'POST', body: 'A'.repeat(100_000) }));
    expect(sample.length).toBeLessThanOrEqual(1024);
    expect(sample.length).toBeGreaterThan(0);
    expect(await readBodySample(new Request('https://x.test/'))).toBe('');
  });
});

describe('reportHold', () => {
  it('posts how a held connection ended, and does nothing without settings', async () => {
    const f = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', f);
    await reportHold(req('/.env'), {}, { heldMs: 5000, outcome: 'gave_up' });
    expect(f).not.toHaveBeenCalled();
    await reportHold(req('/.env'), env(), { heldMs: 5000, outcome: 'gave_up' });
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ kind: 'hold', ip: '198.51.100.7', host: 'site.example', path: '/.env', heldMs: 5000, outcome: 'gave_up' });
  });
});
