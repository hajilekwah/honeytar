-- honeytar: database schema for the ingest function (Supabase / Postgres). Run it once in the SQL editor, or as a migration.
-- Safe to run again: everything is "if not exists", and policies are dropped and recreated.
--
-- Access: the ingest function writes with the service role, which bypasses row level security. Nothing else can read
-- these tables until you teach `public.honeytar_is_admin()` who you are (see the note below). Table names are kept as
-- they were before honeytar was a package, so an existing deployment can run this file as is.

-- Who may read and change the tables through the API. The default says nobody. Replace the body with your own check, for
-- example: select (auth.jwt() ->> 'email') = 'you@example.com'
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'honeytar_is_admin') then
    create function public.honeytar_is_admin() returns boolean language sql stable as 'select false';
  end if;
end
$$;

-- ---------------------------------------------------------------- decoy visits

create table if not exists public.honeypot_hits (
  id uuid primary key default gen_random_uuid(),
  -- One row per site, source, path and day; repeat visits update the row instead of adding new ones.
  fingerprint text not null unique check (char_length(fingerprint) between 3 and 300),
  ip text not null check (char_length(ip) between 1 and 64),
  country text check (country is null or char_length(country) <= 8),
  asn text check (asn is null or char_length(asn) <= 12),
  host text check (host is null or char_length(host) <= 100),
  path text not null check (char_length(path) between 1 and 200),
  method text not null check (method in ('GET', 'POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'PATCH')),
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  hits integer not null default 1 check (hits >= 1),
  -- Up to a few examples of what was sent (query string, selected headers, a short body), already cleaned.
  samples jsonb not null default '[]'::jsonb check (pg_column_size(samples) <= 12288),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- Tarpit results: connections held, total time held, how many scanners gave up, how many waited it out.
  holds integer not null default 0 check (holds >= 0),
  held_ms bigint not null default 0 check (held_ms >= 0),
  gave_up integer not null default 0 check (gave_up >= 0),
  waited_out integer not null default 0 check (waited_out >= 0),
  shortest_gave_up_ms integer check (shortest_gave_up_ms is null or shortest_gave_up_ms >= 0),
  -- What Cloudflare told the Worker about the connection, and the source's reverse-DNS name ('' when it has none).
  as_org text check (as_org is null or char_length(as_org) <= 100),
  city text check (city is null or char_length(city) <= 80),
  region text check (region is null or char_length(region) <= 80),
  colo text check (colo is null or char_length(colo) <= 8),
  http_protocol text check (http_protocol is null or char_length(http_protocol) <= 16),
  tls_version text check (tls_version is null or char_length(tls_version) <= 16),
  via_worker text check (via_worker is null or char_length(via_worker) <= 100),
  rdns text check (rdns is null or char_length(rdns) <= 200)
);
create index if not exists honeypot_hits_last_seen_idx on public.honeypot_hits (last_seen desc);

-- ---------------------------------------------------------------- blocklist ledger

-- The Cloudflare account list "honeypot_blocklist" does the blocking; this table records why and when each entry expires.
create table if not exists public.ip_blocks (
  id uuid primary key default gen_random_uuid(),
  cidr text not null check (char_length(cidr) between 2 and 64),
  ip text not null check (char_length(ip) between 2 and 64),
  reason text not null check (char_length(reason) between 1 and 300),
  source text not null default 'auto' check (source in ('auto', 'retro', 'manual')),
  -- pending: recorded but not yet sent to Cloudflare; active: in the list; expired: removed; failed: could not be sent
  status text not null default 'pending' check (status in ('pending', 'active', 'expired', 'failed')),
  cf_item_id text,
  error text check (error is null or char_length(error) <= 300),
  blocked_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create unique index if not exists ip_blocks_live_cidr_idx on public.ip_blocks (cidr) where status in ('pending', 'active');
create index if not exists ip_blocks_expiry_idx on public.ip_blocks (status, expires_at);

-- Addresses that must never be blocked (your own connections, monitors). The ingest function checks this before blocking.
create table if not exists public.ip_allowlist (
  id uuid primary key default gen_random_uuid(),
  cidr text not null unique check (char_length(cidr) between 2 and 64),
  note text check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- access

alter table public.honeypot_hits enable row level security;
alter table public.ip_blocks enable row level security;
alter table public.ip_allowlist enable row level security;
revoke all on table public.honeypot_hits from anon;
revoke all on table public.ip_blocks from anon;
revoke all on table public.ip_allowlist from anon;

drop policy if exists "honeytar admin access on honeypot hits" on public.honeypot_hits;
create policy "honeytar admin access on honeypot hits" on public.honeypot_hits for all to authenticated using (public.honeytar_is_admin()) with check (public.honeytar_is_admin());
drop policy if exists "honeytar admin access on ip blocks" on public.ip_blocks;
create policy "honeytar admin access on ip blocks" on public.ip_blocks for all to authenticated using (public.honeytar_is_admin()) with check (public.honeytar_is_admin());
drop policy if exists "honeytar admin access on ip allowlist" on public.ip_allowlist;
create policy "honeytar admin access on ip allowlist" on public.ip_allowlist for all to authenticated using (public.honeytar_is_admin()) with check (public.honeytar_is_admin());
