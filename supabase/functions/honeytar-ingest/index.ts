// Edge function: receives one decoy visit from a Worker running honeytar and stores it in public.honeypot_hits.
// Authentication is a shared secret in the x-honeytar-secret header (the older x-honeypot-secret is also accepted),
// compared with the HONEYTAR_INGEST_SECRET function secret (the older HONEYPOT_INGEST_SECRET is also accepted).
// Repeat visits from the same source to the same path on the same day update one row. The service role key it
// writes with never leaves Supabase. Rows older than 30 days are deleted now and then.
import { createClient } from "npm:@supabase/supabase-js@2";
import { BLOCK, applyHold, blockCidr, blockReason, fingerprintFor, isAllowlisted, mergeSamples, parsePtrAnswer, ptrName, secretMatches, validateHit, validateHold, validateMaze } from "./logic.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// ---------- auto-block (see logic.ts for the rules) ----------
// The Cloudflare account list "honeypot_blocklist" does the blocking; each zone has a custom rule that blocks
// addresses in it (verified bots exempt). Needs three function secrets: CLOUDFLARE_API_TOKEN (permission
// "Account Filter Lists: Edit", this account only), CF_ACCOUNT_ID and CF_BLOCKLIST_ID. Without the token a block
// is still recorded (status "pending") and is sent to Cloudflare as soon as the token is added.
// Everything here is best effort: a failure is logged and never fails or delays recording the hit.

type Db = ReturnType<typeof createClient>;

function cloudflareConfig() {
  const token = Deno.env.get("CLOUDFLARE_API_TOKEN");
  const account = Deno.env.get("CF_ACCOUNT_ID");
  const list = Deno.env.get("CF_BLOCKLIST_ID");
  return token && account && list ? { token, account, list } : null;
}

async function cf(cfg: NonNullable<ReturnType<typeof cloudflareConfig>>, method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfg.account}/rules/lists/${cfg.list}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) throw new Error(`Cloudflare ${res.status}: ${JSON.stringify(json?.errors ?? []).slice(0, 200)}`);
  return json.result;
}

/** Sends every pending block to Cloudflare and marks it active. */
async function flushPending(db: Db) {
  const cfg = cloudflareConfig();
  if (!cfg) return;
  const { data } = await db.from("ip_blocks").select("id, cidr, reason").eq("status", "pending").limit(50);
  for (const row of data ?? []) {
    try {
      await cf(cfg, "POST", "/items", [{ ip: row.cidr, comment: `honeypot: ${row.reason}`.slice(0, 500) }]);
      await db.from("ip_blocks").update({ status: "active", error: null }).eq("id", row.id);
    } catch (err) {
      await db.from("ip_blocks").update({ error: String(err).slice(0, 300) }).eq("id", row.id);
    }
  }
}

/** Removes expired blocks from Cloudflare (looked up by address) and marks them expired. */
async function expireBlocks(db: Db) {
  const { data } = await db.from("ip_blocks").select("id, cidr, status").in("status", ["pending", "active"]).lt("expires_at", new Date().toISOString()).limit(25);
  if (!data?.length) return;
  const cfg = cloudflareConfig();
  for (const row of data) {
    try {
      if (row.status === "active" && cfg) {
        const items = await cf(cfg, "GET", `/items?search=${encodeURIComponent(row.cidr)}&per_page=50`);
        const ids = (items as Array<{ id: string; ip?: string }>).filter((i) => i.ip === row.cidr).map((i) => ({ id: i.id }));
        if (ids.length) await cf(cfg, "DELETE", "/items", { items: ids });
      }
      await db.from("ip_blocks").update({ status: "expired" }).eq("id", row.id);
    } catch (err) {
      await db.from("ip_blocks").update({ error: String(err).slice(0, 300) }).eq("id", row.id);
    }
  }
}

/** Looks at everything this address did in the last day and blocks it when it looks like a scanner. */
async function maybeBlock(db: Db, ip: string, asn: string | null) {
  const since = new Date(Date.now() - BLOCK.windowHours * 3_600_000).toISOString();
  const { data } = await db.from("honeypot_hits").select("path, hits").eq("ip", ip).gte("last_seen", since).limit(500);
  const rows = data ?? [];
  const reason = blockReason(ip, { paths: new Set(rows.map((r) => r.path)).size, hits: rows.reduce((n, r) => n + (r.hits ?? 0), 0), asn });
  const cidr = blockCidr(ip);
  if (!reason || !cidr) return;
  const allow = await db.from("ip_allowlist").select("cidr");
  if (isAllowlisted(ip, (allow.data ?? []).map((a) => a.cidr))) return;
  const existing = await db.from("ip_blocks").select("id").eq("cidr", cidr).in("status", ["pending", "active"]).maybeSingle();
  if (existing.data) return;
  await db.from("ip_blocks").insert({ cidr, ip, reason, source: "auto", status: "pending", expires_at: new Date(Date.now() + BLOCK.ttlHours * 3_600_000).toISOString() });
}

async function blockPass(db: Db, ip: string, asn: string | null) {
  try {
    await maybeBlock(db, ip, asn);
    await flushPending(db);
    await expireBlocks(db);
  } catch (err) {
    console.error("Auto-block pass failed:", err);
  }
}

/**
 * Adds a tarpit result to the most recent row for the same site, source and path. A scanner that gives up very quickly
 * can report its hold before the visit's own row has been saved, so look a few times before concluding there is no row.
 */
async function recordHold(body: unknown): Promise<Response> {
  const { hold, error } = validateHold(body);
  if (!hold) return json(400, { error: error ?? "invalid hold" });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const find = () => {
    let q = db.from("honeypot_hits").select("id, holds, held_ms, gave_up, waited_out, shortest_gave_up_ms").eq("ip", hold.ip).eq("path", hold.path);
    if (hold.host) q = q.eq("host", hold.host);
    return q.order("last_seen", { ascending: false }).limit(1).maybeSingle();
  };
  let row = await find();
  for (let attempt = 0; attempt < 3 && !row.data && !row.error; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    row = await find();
  }
  if (row.error) return json(500, { error: "lookup failed" });
  if (!row.data) return json(200, { ok: true, matched: false });
  const r = await db.from("honeypot_hits").update(applyHold(row.data, hold)).eq("id", row.data.id);
  if (r.error) return json(500, { error: "update failed" });
  return json(200, { ok: true, matched: true });
}

/**
 * One crawler-maze page view. Counted by a single atomic database function, so a crawler fetching many pages at once
 * cannot lose counts. The reverse DNS name is looked up once, when the day's row is first created. Recorded only: a maze
 * view never triggers a block.
 */
async function recordMaze(body: unknown): Promise<Response> {
  const { visit, error } = validateMaze(body);
  if (!visit) return json(400, { error: error ?? "invalid maze view" });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const r = await db.rpc("honeytar_record_maze", {
    p_host: visit.host, p_ip: visit.ip, p_path: visit.path, p_depth: visit.depth, p_held_ms: visit.heldMs,
    p_gave_up: visit.outcome === "gave_up", p_has_referer: visit.hasReferer, p_user_agent: visit.userAgent,
    p_country: visit.country, p_asn: visit.asn, p_as_org: visit.asOrg, p_city: visit.city, p_region: visit.region,
    p_colo: visit.colo, p_http_protocol: visit.httpProtocol, p_tls_version: visit.tlsVersion, p_via_worker: visit.viaWorker,
  });
  if (r.error) return json(500, { error: "maze record failed" });
  if (r.data === true) {
    const rdns = await reverseName(db, visit.ip);
    if (rdns !== null) {
      const day = new Date().toISOString().slice(0, 10);
      const site = visit.host ? `${visit.host.toLowerCase().replace(/^www\./, "")}|` : "";
      await db.from("honeypot_maze").update({ rdns }).eq("fingerprint", `${site}${visit.ip}|${day}`);
    }
  }
  return json(200, { ok: true });
}

/** The optional connection details from a hit, as database columns (only the ones present, so a later hit never blanks an earlier one). */
function connectionFields(hit: { asOrg: string | null; city: string | null; region: string | null; colo: string | null; httpProtocol: string | null; tlsVersion: string | null; viaWorker: string | null }) {
  const out: Record<string, string> = {};
  if (hit.asOrg) out.as_org = hit.asOrg;
  if (hit.city) out.city = hit.city;
  if (hit.region) out.region = hit.region;
  if (hit.colo) out.colo = hit.colo;
  if (hit.httpProtocol) out.http_protocol = hit.httpProtocol;
  if (hit.tlsVersion) out.tls_version = hit.tlsVersion;
  if (hit.viaWorker) out.via_worker = hit.viaWorker;
  return out;
}

/**
 * The hostname behind a source address (reverse DNS), looked up over DNS-over-HTTPS. Reuses what is already stored for
 * the address, and stores "" when there is no name so the lookup is not repeated. Best effort: null on any failure.
 */
async function reverseName(db: Db, ip: string): Promise<string | null> {
  try {
    const known = await db.from("honeypot_hits").select("rdns").eq("ip", ip).not("rdns", "is", null).limit(1).maybeSingle();
    if (known.data) return known.data.rdns as string;
    const name = ptrName(ip);
    if (!name) return null;
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=PTR`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return parsePtrAnswer(await res.json()) ?? "";
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  const presented = req.headers.get("x-honeytar-secret") ?? req.headers.get("x-honeypot-secret");
  const configured = Deno.env.get("HONEYTAR_INGEST_SECRET") ?? Deno.env.get("HONEYPOT_INGEST_SECRET");
  if (!secretMatches(configured, presented)) return json(401, { error: "unauthorized" });

  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 20_000) return json(413, { error: "too large" });
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  // A tarpit result (how long a decoy was held and how it ended) updates the matching row's totals.
  if ((body as { kind?: unknown } | null)?.kind === "hold") return await recordHold(body);
  // A crawler-maze page view is counted on the day's row for that site and source.
  if ((body as { kind?: unknown } | null)?.kind === "maze") return await recordMaze(body);

  const { hit, error } = validateHit(body);
  if (!hit) return json(400, { error: error ?? "invalid hit" });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const fingerprint = fingerprintFor(hit);
  const existing = await db.from("honeypot_hits").select("id, hits, samples").eq("fingerprint", fingerprint).maybeSingle();
  if (existing.error) return json(500, { error: "lookup failed" });

  if (existing.data) {
    const r = await db.from("honeypot_hits").update({
      hits: existing.data.hits + 1,
      last_seen: new Date().toISOString(),
      samples: mergeSamples(existing.data.samples, hit.sample),
      ...connectionFields(hit),
    }).eq("id", existing.data.id);
    if (r.error) return json(500, { error: "update failed" });
  } else {
    // Save the visit first, then look up the hostname: the lookup can take a couple of seconds, and a hold result for a
    // fast-leaving scanner must find the row.
    const r = await db.from("honeypot_hits").insert({
      fingerprint, ip: hit.ip, country: hit.country, asn: hit.asn, host: hit.host, path: hit.path,
      method: hit.method, user_agent: hit.userAgent, samples: [hit.sample],
      ...connectionFields(hit),
    });
    if (r.error) return json(500, { error: "insert failed" });
    const rdns = await reverseName(db, hit.ip);
    if (rdns !== null) await db.from("honeypot_hits").update({ rdns }).eq("fingerprint", fingerprint);
  }

  // Retention: about one request in twenty tidies up rows older than 30 days.
  if (Math.random() < 0.05) {
    await db.from("honeypot_hits").delete().lt("last_seen", new Date(Date.now() - 30 * 86_400_000).toISOString());
  }
  await blockPass(db, hit.ip, hit.asn);
  return json(200, { ok: true, new: !existing.data });
});
