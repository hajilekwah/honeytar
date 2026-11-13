// Pure helpers for the honeytar-ingest edge function: the shared-secret check, and cleaning and validating
// one honeypot hit. Everything in a hit is attacker-controlled, so every text field is reduced to printable
// ASCII (no angle brackets) and capped before it goes anywhere near the database or a screen.
// No Deno or network APIs here, so the same file is tested with Vitest and deployed unchanged.

export const METHODS = ["GET", "POST", "HEAD", "PUT", "DELETE", "OPTIONS", "PATCH"] as const;
export const LIMITS = { path: 200, query: 200, ua: 300, host: 100, body: 512, header: 120, samples: 5 } as const;
/** Request headers worth keeping as evidence. Anything else is dropped. */
export const KEPT_HEADERS = ["accept", "accept-language", "content-type", "origin", "referer"] as const;

export interface HoneypotSample {
  t: string;
  query: string;
  body: string;
  headers: Record<string, string>;
}

export interface HoneypotHit {
  ip: string;
  country: string | null;
  asn: string | null;
  host: string | null;
  path: string;
  method: (typeof METHODS)[number];
  userAgent: string | null;
  /** What Cloudflare told the Worker about the connection (all optional): the network's name, where it is, which data
   * center answered, the HTTP and TLS versions used, and the zone of a Cloudflare Worker that made the request, if any. */
  asOrg: string | null;
  city: string | null;
  region: string | null;
  colo: string | null;
  httpProtocol: string | null;
  tlsVersion: string | null;
  viaWorker: string | null;
  sample: HoneypotSample;
}

/** Printable ASCII only, angle brackets removed, whitespace collapsed, capped (with a trailing "~"). */
export function cleanText(value: unknown, max: number): string {
  const s = String(value ?? "").replace(/[^\x20-\x7e]|[<>]/g, "_").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}~` : s;
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** A configured secret of at least 16 characters (whitespace ignored on both sides) must equal the presented one. */
export function secretMatches(configured: string | undefined, presented: string | null): boolean {
  const secret = configured?.trim();
  if (!secret || secret.length < 16 || presented === null) return false;
  return timingSafeEqual(secret, presented.trim());
}

const IP = /^[0-9a-fA-F:.]{2,45}$/;
const COUNTRY = /^[A-Za-z0-9]{1,8}$/;
const ASN = /^\d{1,12}$/;

/** A cleaned optional text field, or null when absent or empty. */
function optText(value: unknown, max: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return cleanText(value, max);
}

/** Validates one hit from the Worker. Returns the cleaned hit, or a reason it was refused. */
export function validateHit(body: unknown, now: number = Date.now()): { hit?: HoneypotHit; error?: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "body must be an object" };
  if (typeof b.ip !== "string" || !IP.test(b.ip)) return { error: "ip is invalid" };
  if (typeof b.path !== "string" || b.path.length === 0 || !b.path.startsWith("/")) return { error: "path is invalid" };
  if (!METHODS.includes(b.method as never)) return { error: "method is not allowed" };
  const headers: Record<string, string> = {};
  const raw = b.headers && typeof b.headers === "object" && !Array.isArray(b.headers) ? (b.headers as Record<string, unknown>) : {};
  for (const key of KEPT_HEADERS) if (typeof raw[key] === "string" && raw[key]) headers[key] = cleanText(raw[key], LIMITS.header);
  return {
    hit: {
      ip: b.ip,
      country: typeof b.country === "string" && COUNTRY.test(b.country) ? b.country.toLowerCase() : null,
      asn: typeof b.asn === "string" && ASN.test(b.asn) ? b.asn : typeof b.asn === "number" && Number.isInteger(b.asn) && b.asn >= 0 ? String(b.asn) : null,
      host: typeof b.host === "string" && b.host ? cleanText(b.host, LIMITS.host) : null,
      path: cleanText(b.path, LIMITS.path),
      method: b.method as HoneypotHit["method"],
      userAgent: typeof b.userAgent === "string" && b.userAgent ? cleanText(b.userAgent, LIMITS.ua) : null,
      asOrg: optText(b.asOrg, 100),
      city: optText(b.city, 80),
      region: optText(b.region, 80),
      colo: typeof b.colo === "string" && /^[A-Za-z0-9]{1,8}$/.test(b.colo) ? b.colo.toUpperCase() : null,
      httpProtocol: optText(b.httpProtocol, 16),
      tlsVersion: optText(b.tlsVersion, 16),
      viaWorker: optText(b.viaWorker, 100),
      sample: { t: new Date(now).toISOString(), query: cleanText(b.query, LIMITS.query), body: cleanText(b.body, LIMITS.body), headers },
    },
  };
}

/** One row per site, source, path and day (the same source on two sites is two rows). */
export function fingerprintFor(hit: Pick<HoneypotHit, "ip" | "path"> & { host?: string | null }, now: number = Date.now()): string {
  const site = hit.host ? `${hit.host.toLowerCase().replace(/^www\./, "")}|` : "";
  return `${site}${hit.ip}|${hit.path}|${new Date(now).toISOString().slice(0, 10)}`.slice(0, 300);
}

/** Keeps up to `max` examples: new ones are added until full, then the newest replaces the last slot. */
export function mergeSamples(existing: unknown, sample: HoneypotSample, max: number = LIMITS.samples): HoneypotSample[] {
  const list = Array.isArray(existing) ? (existing as HoneypotSample[]).slice(0, max) : [];
  if (list.length < max) return [...list, sample];
  return [...list.slice(0, max - 1), sample];
}

// ---------- auto-block ----------
// A source that probes several different decoy paths in a day is a scanner, not a person who typed /.env once.
// Counting distinct paths (not raw hits) is what keeps the owner's own tests from getting them locked out.

export const BLOCK = {
  /** Look back this far at an address's decoy hits. */
  windowHours: 24,
  /** Block at this many different decoy paths in the window... */
  minPaths: 4,
  /** ...or this many hits in total. */
  minHits: 20,
  /** How long a block lasts. */
  ttlHours: 24,
  /** Cloudflare's own network: never block it (its own fetchers and WARP users share these addresses). */
  neverBlockAsn: ["13335"],
} as const;

/** An IPv4 or IPv6 address as a number, with its version. Null when it is not an address. */
export function parseIp(ip: string): { v: 4 | 6; n: bigint } | null {
  const s = ip.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const parts = s.split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    return { v: 4, n: parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n) };
  }
  if (!/^[0-9a-fA-F:]+$/.test(s) || !s.includes(":") || (s.match(/::/g) ?? []).length > 1) return null;
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  if (s.includes("::") ? h.length + t.length > 7 : h.length !== 8) return null;
  const groups = s.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  if (groups.length !== 8 || groups.some((g) => g === "" || g.length > 4)) return null;
  return { v: 6, n: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n) };
}

/** True when `ip` is inside `cidr` (a bare address means that one address). */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.trim().split("/");
  const a = parseIp(ip);
  const b = parseIp(base ?? "");
  if (!a || !b || a.v !== b.v) return false;
  const total = a.v === 4 ? 32 : 128;
  const bits = bitsText === undefined ? total : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > total) return false;
  const shift = BigInt(total - bits);
  return a.n >> shift === b.n >> shift;
}

/** Private, loopback, link-local and other addresses that are never a remote scanner. */
export function isReservedIp(ip: string): boolean {
  const p = parseIp(ip);
  if (!p) return true;
  const reserved4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4", "240.0.0.0/4"];
  const reserved6 = ["::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8"];
  return (p.v === 4 ? reserved4 : reserved6).some((c) => ipInCidr(ip, c));
}

/** What goes in the Cloudflare list: an IPv4 address as is, an IPv6 address as its /64 (scanners rotate inside it). */
export function blockCidr(ip: string): string | null {
  const p = parseIp(ip);
  if (!p) return null;
  if (p.v === 4) return ip.trim();
  const net = (p.n >> 64n) << 64n;
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((net >> BigInt(i * 16)) & 0xffffn).toString(16));
  return `${groups.slice(0, 4).join(":")}::/64`;
}

export interface SourceStats { paths: number; hits: number; asn: string | null }

/** The reason to block a source, or null. Pure: the allowlist and existing blocks are checked by the caller. */
export function blockReason(ip: string, stats: SourceStats): string | null {
  if (isReservedIp(ip)) return null;
  if (stats.asn && (BLOCK.neverBlockAsn as readonly string[]).includes(stats.asn)) return null;
  if (stats.paths >= BLOCK.minPaths) return `${stats.paths} different decoy paths in ${BLOCK.windowHours}h (${stats.hits} hits)`;
  if (stats.hits >= BLOCK.minHits) return `${stats.hits} decoy hits in ${BLOCK.windowHours}h (${stats.paths} paths)`;
  return null;
}

/** True when the address is covered by any allowlist entry. */
export function isAllowlisted(ip: string, allowlist: string[]): boolean {
  return allowlist.some((c) => ipInCidr(ip, c));
}

// ---------- tarpit results ----------
// After a decoy is held back (the tarpit), the site Worker reports how long the connection was held and how it
// ended: the scanner hung up first ("gave_up") or waited the whole hold ("completed").

export const HOLD = { maxMs: 120_000 } as const;
export const HOLD_OUTCOMES = ["gave_up", "completed"] as const;

export interface HoldReport {
  ip: string;
  host: string | null;
  path: string;
  heldMs: number;
  outcome: (typeof HOLD_OUTCOMES)[number];
}

/** Validates a tarpit result from a Worker. Returns the cleaned report, or a reason it was refused. */
export function validateHold(body: unknown): { hold?: HoldReport; error?: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "body must be an object" };
  if (typeof b.ip !== "string" || !IP.test(b.ip)) return { error: "ip is invalid" };
  if (typeof b.path !== "string" || b.path.length === 0 || !b.path.startsWith("/")) return { error: "path is invalid" };
  if (!HOLD_OUTCOMES.includes(b.outcome as never)) return { error: "outcome is invalid" };
  if (typeof b.heldMs !== "number" || !Number.isFinite(b.heldMs) || b.heldMs < 0) return { error: "heldMs is invalid" };
  return {
    hold: {
      ip: b.ip,
      host: typeof b.host === "string" && b.host ? cleanText(b.host, LIMITS.host) : null,
      path: cleanText(b.path, LIMITS.path),
      heldMs: Math.min(Math.round(b.heldMs), HOLD.maxMs),
      outcome: b.outcome as HoldReport["outcome"],
    },
  };
}

export interface HoldTotals { holds: number; held_ms: number; gave_up: number; waited_out: number; shortest_gave_up_ms: number | null }

/** Adds one result to a row's running totals. */
export function applyHold(row: Partial<HoldTotals> | null | undefined, hold: Pick<HoldReport, "heldMs" | "outcome">): HoldTotals {
  const gaveUp = hold.outcome === "gave_up";
  const prev = row?.shortest_gave_up_ms ?? null;
  return {
    holds: (row?.holds ?? 0) + 1,
    held_ms: (row?.held_ms ?? 0) + hold.heldMs,
    gave_up: (row?.gave_up ?? 0) + (gaveUp ? 1 : 0),
    waited_out: (row?.waited_out ?? 0) + (gaveUp ? 0 : 1),
    shortest_gave_up_ms: gaveUp ? (prev === null ? hold.heldMs : Math.min(prev, hold.heldMs)) : prev,
  };
}

// ---------- reverse DNS ----------
// The hostname behind an address often names a hosting provider or a research scanner. The ingest function asks a
// public resolver over HTTPS (DNS-over-HTTPS) once per new source.

/** The reverse-lookup name for an address (4.3.2.1.in-addr.arpa, or nibbles under ip6.arpa), or null when it is not an address. */
export function ptrName(ip: string): string | null {
  const p = parseIp(ip);
  if (!p) return null;
  if (p.v === 4) return `${ip.trim().split(".").reverse().join(".")}.in-addr.arpa`;
  const hex = p.n.toString(16).padStart(32, "0");
  return `${hex.split("").reverse().join(".")}.ip6.arpa`;
}

/** The first PTR hostname in a DNS-over-HTTPS JSON answer (lower case, no trailing dot), or null. */
export function parsePtrAnswer(body: unknown): string | null {
  const answers = (body as { Answer?: unknown } | null)?.Answer;
  if (!Array.isArray(answers)) return null;
  for (const a of answers as Array<{ type?: unknown; data?: unknown }>) {
    if (a?.type === 12 && typeof a.data === "string" && a.data.trim()) {
      const name = cleanText(a.data.trim().replace(/\.$/, "").toLowerCase(), 200);
      if (name) return name;
    }
  }
  return null;
}

// ---------- crawler maze ----------
// Each page a crawler fetches in the maze is reported with its depth, how long it was held and how that ended. The
// database function public.honeytar_record_maze adds it to the day's row for that site and source. Recorded only:
// nothing here blocks anyone.

export const MAZE_LIMITS = { maxDepth: 50 } as const;

export interface MazeVisit {
  ip: string;
  host: string | null;
  path: string;
  depth: number;
  heldMs: number;
  outcome: (typeof HOLD_OUTCOMES)[number];
  hasReferer: boolean;
  userAgent: string | null;
  country: string | null;
  asn: string | null;
  asOrg: string | null;
  city: string | null;
  region: string | null;
  colo: string | null;
  httpProtocol: string | null;
  tlsVersion: string | null;
  viaWorker: string | null;
}

/** Validates one maze page view from a Worker. Returns the cleaned view, or a reason it was refused. */
export function validateMaze(body: unknown): { visit?: MazeVisit; error?: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "body must be an object" };
  if (typeof b.ip !== "string" || !IP.test(b.ip)) return { error: "ip is invalid" };
  if (typeof b.path !== "string" || b.path.length === 0 || !b.path.startsWith("/")) return { error: "path is invalid" };
  if (!HOLD_OUTCOMES.includes(b.outcome as never)) return { error: "outcome is invalid" };
  if (typeof b.heldMs !== "number" || !Number.isFinite(b.heldMs) || b.heldMs < 0) return { error: "heldMs is invalid" };
  if (typeof b.depth !== "number" || !Number.isInteger(b.depth) || b.depth < 0) return { error: "depth is invalid" };
  return {
    visit: {
      ip: b.ip,
      host: typeof b.host === "string" && b.host ? cleanText(b.host, LIMITS.host) : null,
      path: cleanText(b.path, LIMITS.path),
      depth: Math.min(b.depth, MAZE_LIMITS.maxDepth),
      heldMs: Math.min(Math.round(b.heldMs), HOLD.maxMs),
      outcome: b.outcome as MazeVisit["outcome"],
      hasReferer: typeof b.referer === "string" && b.referer.length > 0,
      userAgent: typeof b.userAgent === "string" && b.userAgent ? cleanText(b.userAgent, LIMITS.ua) : null,
      country: typeof b.country === "string" && COUNTRY.test(b.country) ? b.country.toLowerCase() : null,
      asn: typeof b.asn === "string" && ASN.test(b.asn) ? b.asn : null,
      asOrg: optText(b.asOrg, 100),
      city: optText(b.city, 80),
      region: optText(b.region, 80),
      colo: typeof b.colo === "string" && /^[A-Za-z0-9]{1,8}$/.test(b.colo) ? b.colo.toUpperCase() : null,
      httpProtocol: optText(b.httpProtocol, 16),
      tlsVersion: optText(b.tlsVersion, 16),
      viaWorker: optText(b.viaWorker, 100),
    },
  };
}
