import { describe, it, expect } from 'vitest';
import { cleanText, fingerprintFor, mergeSamples, secretMatches, validateHit, LIMITS, type HoneypotSample } from '../supabase/functions/honeytar-ingest/logic';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const good = { ip: '198.51.100.7', country: 'RU', asn: 12345, host: 'site.example', path: '/wp-login.php', method: 'POST', userAgent: 'curl/8.0', query: '?a=1', body: 'log=admin&pwd=hunter2', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'secret=1' } };

describe('cleanText', () => {
  it('keeps printable ASCII, drops everything else and angle brackets, collapses space, and caps with a marker', () => {
    expect(cleanText('log=admin&pwd=<script>\u0000‮ x', 100)).toBe('log=admin&pwd=_script___ x');
    expect(cleanText('a'.repeat(50), 10)).toBe('aaaaaaaaa~');
    expect(cleanText(undefined, 10)).toBe('');
  });
});

describe('secretMatches', () => {
  it('needs a long enough configured secret and ignores surrounding whitespace', () => {
    const s = 'k'.repeat(32);
    expect(secretMatches(s + '\n', s)).toBe(true);
    expect(secretMatches(s, s + 'x')).toBe(false);
    expect(secretMatches(undefined, s)).toBe(false);
    expect(secretMatches('short', 'short')).toBe(false);
    expect(secretMatches(s, null)).toBe(false);
  });
});

describe('validateHit', () => {
  it('accepts a good hit and cleans it, lower-casing the country and dropping headers that are not kept', () => {
    const { hit, error } = validateHit(good, NOW);
    expect(error).toBeUndefined();
    expect(hit).toMatchObject({ ip: '198.51.100.7', country: 'ru', asn: '12345', path: '/wp-login.php', method: 'POST', userAgent: 'curl/8.0' });
    expect(hit?.sample).toEqual({ t: '2026-11-09T12:00:00.000Z', query: '?a=1', body: 'log=admin&pwd=hunter2', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  });
  it.each([
    ['not an object', null],
    ['an array', []],
    ['a bad ip', { ...good, ip: 'not an ip!' }],
    ['a path that does not start with a slash', { ...good, path: 'wp-login.php' }],
    ['a method that is not allowed', { ...good, method: 'TRACE' }],
  ])('refuses %s', (_label, body) => {
    expect(validateHit(body, NOW).hit).toBeUndefined();
  });
  it('turns hostile text into harmless capped text', () => {
    const { hit } = validateHit({ ...good, path: '/x<script>alert(1)</script>' + 'A'.repeat(500), body: '\u001b[31m' + 'B'.repeat(2000), userAgent: '<b>bot</b>' }, NOW);
    expect(hit?.path).toHaveLength(LIMITS.path);
    expect(hit?.path).not.toMatch(/[<>]/);
    expect(hit?.sample.body).toHaveLength(LIMITS.body);
    expect(hit?.userAgent).toBe('_b_bot_/b_');
  });
  it('tolerates a missing country, asn, host and headers', () => {
    const { hit } = validateHit({ ip: '::1', path: '/.env', method: 'GET' }, NOW);
    expect(hit).toMatchObject({ country: null, asn: null, host: null, userAgent: null });
    expect(hit?.sample.headers).toEqual({});
  });
});

describe('fingerprintFor and mergeSamples', () => {
  it('is one row per source, path and day', () => {
    expect(fingerprintFor({ ip: '1.2.3.4', path: '/.env' }, NOW)).toBe('1.2.3.4|/.env|2026-11-09');
    expect(fingerprintFor({ ip: '1.2.3.4', path: '/.env' }, NOW + 86_400_000)).not.toBe(fingerprintFor({ ip: '1.2.3.4', path: '/.env' }, NOW));
  });
  it('is one row per site too, ignoring www. and case', () => {
    expect(fingerprintFor({ ip: '1.2.3.4', path: '/.env', host: 'WWW.Other.Example' }, NOW)).toBe('other.example|1.2.3.4|/.env|2026-11-09');
    expect(fingerprintFor({ ip: '1.2.3.4', path: '/.env', host: 'a.example' }, NOW)).not.toBe(fingerprintFor({ ip: '1.2.3.4', path: '/.env', host: 'b.example' }, NOW));
  });
  it('adds examples until full, then replaces only the last slot', () => {
    const s = (n: number): HoneypotSample => ({ t: String(n), query: '', body: '', headers: {} });
    let list: HoneypotSample[] = [];
    for (let i = 1; i <= LIMITS.samples; i++) list = mergeSamples(list, s(i));
    expect(list.map((x) => x.t)).toEqual(['1', '2', '3', '4', '5']);
    expect(mergeSamples(list, s(6)).map((x) => x.t)).toEqual(['1', '2', '3', '4', '6']);
    expect(mergeSamples('garbage', s(1))).toEqual([s(1)]);
  });
});

import { BLOCK, blockCidr, blockReason, ipInCidr, isAllowlisted, isReservedIp, parseIp } from "../supabase/functions/honeytar-ingest/logic";

describe("auto-block rules", () => {
  it("parses and matches IPv4 and IPv6", () => {
    expect(parseIp("203.0.113.9")).not.toBeNull();
    expect(parseIp("2603:8003:4340:17c8::1")).not.toBeNull();
    expect(parseIp("2603:8003:4340:17c8:b4c0:c874:dbaa:552b")).not.toBeNull();
    for (const bad of ["", "999.1.1.1", "1.2.3", "abc", "1::2::3", "12345::1"]) expect(parseIp(bad)).toBeNull();
    expect(ipInCidr("203.0.113.9", "203.0.113.0/24")).toBe(true);
    expect(ipInCidr("203.0.114.9", "203.0.113.0/24")).toBe(false);
    expect(ipInCidr("203.0.113.9", "203.0.113.9")).toBe(true);
    expect(ipInCidr("2603:8003:4340:17c8:b4c0:c874:dbaa:552b", "2603:8003:4340:17c8::/64")).toBe(true);
    expect(ipInCidr("2603:8003:4340:17c9::1", "2603:8003:4340:17c8::/64")).toBe(false);
    expect(ipInCidr("203.0.113.9", "2603::/64")).toBe(false);
  });
  it("turns an address into the list entry", () => {
    expect(blockCidr("203.0.113.9")).toBe("203.0.113.9");
    expect(blockCidr("2603:8003:4340:17c8:b4c0:c874:dbaa:552b")).toBe("2603:8003:4340:17c8::/64");
    expect(blockCidr("2a06:98c0:3600::103")).toBe("2a06:98c0:3600:0::/64");
    expect(blockCidr("nonsense")).toBeNull();
  });
  it("never treats private or reserved addresses as scanners", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "192.168.1.5", "172.20.0.1", "::1", "fe80::1", "fd00::5"]) expect(isReservedIp(ip)).toBe(true);
    expect(isReservedIp("8.8.8.8")).toBe(false);
    expect(blockReason("10.1.2.3", { paths: 50, hits: 500, asn: null })).toBeNull();
  });
  it("blocks on distinct paths or heavy volume, but not on one path tested on several sites", () => {
    expect(blockReason("203.0.113.9", { paths: BLOCK.minPaths, hits: 4, asn: "14061" })).toMatch(/different decoy paths/);
    expect(blockReason("203.0.113.9", { paths: 2, hits: BLOCK.minHits, asn: null })).toMatch(/decoy hits/);
    // the owner testing /.env on three sites: one path, three hits
    expect(blockReason("203.0.113.9", { paths: 1, hits: 3, asn: "20001" })).toBeNull();
    expect(blockReason("203.0.113.9", { paths: BLOCK.minPaths - 1, hits: BLOCK.minHits - 1, asn: null })).toBeNull();
  });
  it("never blocks Cloudflare's own network", () => {
    expect(blockReason("104.28.201.80", { paths: 57, hits: 96, asn: "13335" })).toBeNull();
  });
  it("honours the allowlist", () => {
    expect(isAllowlisted("2603:8003:4340:17c8:1::9", ["198.51.100.0/24", "2603:8003:4340:17c8::/64"])).toBe(true);
    expect(isAllowlisted("203.0.113.9", ["198.51.100.0/24"])).toBe(false);
    expect(isAllowlisted("203.0.113.9", [])).toBe(false);
  });
});

import { HOLD, applyHold, validateHold } from "../supabase/functions/honeytar-ingest/logic";

describe("tarpit results", () => {
  const ok = { ip: "203.0.113.9", host: "other.example", path: "/.env", heldMs: 5012, outcome: "gave_up" };
  it("validates a hold report and caps the time", () => {
    expect(validateHold(ok).hold).toEqual({ ip: "203.0.113.9", host: "other.example", path: "/.env", heldMs: 5012, outcome: "gave_up" });
    expect(validateHold({ ...ok, heldMs: 9e9 }).hold?.heldMs).toBe(HOLD.maxMs);
    expect(validateHold({ ...ok, host: undefined }).hold?.host).toBeNull();
  });
  it("refuses bad reports", () => {
    for (const bad of [null, [], { ...ok, ip: "nope" }, { ...ok, path: "env" }, { ...ok, outcome: "other" }, { ...ok, heldMs: -1 }, { ...ok, heldMs: "5" }, { ...ok, heldMs: NaN }]) expect(validateHold(bad).error).toBeTruthy();
  });
  it("adds results to running totals and tracks the quickest give-up", () => {
    const a = applyHold(null, { heldMs: 5000, outcome: "gave_up" });
    expect(a).toEqual({ holds: 1, held_ms: 5000, gave_up: 1, waited_out: 0, shortest_gave_up_ms: 5000 });
    const b = applyHold(a, { heldMs: 30000, outcome: "completed" });
    expect(b).toEqual({ holds: 2, held_ms: 35000, gave_up: 1, waited_out: 1, shortest_gave_up_ms: 5000 });
    const c = applyHold(b, { heldMs: 2000, outcome: "gave_up" });
    expect(c.shortest_gave_up_ms).toBe(2000);
    expect(applyHold({ shortest_gave_up_ms: 3000 }, { heldMs: 9000, outcome: "gave_up" }).shortest_gave_up_ms).toBe(3000);
  });
});

import { parsePtrAnswer, ptrName } from "../supabase/functions/honeytar-ingest/logic";

describe("connection details and reverse DNS", () => {
  const base = { ip: "203.0.113.9", path: "/.env", method: "GET" };
  it("keeps cleaned optional connection details, and nulls what is missing or odd", () => {
    const { hit } = validateHit({ ...base, asOrg: "DigitalOcean, LLC", city: "Amsterdam", region: "North Holland", colo: "ams", httpProtocol: "HTTP/1.1", tlsVersion: "TLSv1.2", viaWorker: "some-zone.example" });
    expect(hit).toMatchObject({ asOrg: "DigitalOcean, LLC", city: "Amsterdam", region: "North Holland", colo: "AMS", httpProtocol: "HTTP/1.1", tlsVersion: "TLSv1.2", viaWorker: "some-zone.example" });
    const bare = validateHit(base).hit;
    expect(bare).toMatchObject({ asOrg: null, city: null, region: null, colo: null, httpProtocol: null, tlsVersion: null, viaWorker: null });
    expect(validateHit({ ...base, colo: "not a colo!", asOrg: "   ", city: 5 }).hit).toMatchObject({ colo: null, asOrg: null, city: null });
  });
  it("cleans and caps connection details like every other attacker-controlled field", () => {
    const hit = validateHit({ ...base, asOrg: "<script>" + "x".repeat(300), viaWorker: "a\nb" }).hit!;
    expect(hit.asOrg!.length).toBeLessThanOrEqual(100);
    expect(hit.asOrg).not.toMatch(/[<>]/);
    expect(hit.viaWorker).toBe("a_b");
  });
  it("builds the reverse-lookup name for IPv4 and IPv6", () => {
    expect(ptrName("203.0.113.9")).toBe("9.113.0.203.in-addr.arpa");
    expect(ptrName("2001:db8::1")).toBe("1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa");
    expect(ptrName("nope")).toBeNull();
  });
  it("reads the PTR hostname from a DNS-over-HTTPS answer", () => {
    expect(parsePtrAnswer({ Answer: [{ type: 5, data: "x." }, { type: 12, data: "Scanner.Example.COM." }] })).toBe("scanner.example.com");
    expect(parsePtrAnswer({ Status: 3 })).toBeNull();
    expect(parsePtrAnswer({ Answer: [{ type: 12, data: "  " }] })).toBeNull();
    expect(parsePtrAnswer(null)).toBeNull();
    expect(parsePtrAnswer({ Answer: "bad" })).toBeNull();
  });
});
