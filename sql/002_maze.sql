-- honeytar crawler maze (optional): one row per site, source address and day, updated atomically for every maze page view.
-- Run after 001_honeytar.sql. Safe to run again.

create table if not exists public.honeypot_maze (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique,            -- site|address|day
  host text,
  ip text not null,
  user_agent text,
  country text,
  asn text,
  as_org text,
  city text,
  region text,
  colo text,
  http_protocol text,
  tls_version text,
  via_worker text,
  rdns text,
  pages integer not null default 0,            -- page views in total
  distinct_pages integer not null default 0,   -- different pages (counted up to 100)
  max_depth integer not null default 0,        -- deepest level reached
  held_ms bigint not null default 0,           -- total time pages were held back
  gave_up integer not null default 0,          -- views where the crawler hung up first
  waited_out integer not null default 0,       -- views where it waited the whole hold
  min_gap_ms integer,                          -- shortest time between two views
  gap_total_ms bigint not null default 0,      -- sum of the gaps (average = this / (pages - 1))
  referer_pages integer not null default 0,    -- views that carried a Referer header
  trail jsonb not null default '[]'::jsonb,    -- the first 100 different pages, in the order they were fetched
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index if not exists honeypot_maze_last_seen_idx on public.honeypot_maze (last_seen desc);

alter table public.honeypot_maze enable row level security;
revoke all on table public.honeypot_maze from anon;
drop policy if exists "honeytar admin access on honeypot maze" on public.honeypot_maze;
create policy "honeytar admin access on honeypot maze" on public.honeypot_maze for all to authenticated using (public.honeytar_is_admin()) with check (public.honeytar_is_admin());

-- One atomic upsert per page view, so a crawler fetching many pages at once cannot lose counts. Returns true when it
-- created the day's row (the ingest function then looks up the reverse DNS name once).
create or replace function public.honeytar_record_maze(
  p_host text, p_ip text, p_path text, p_depth integer, p_held_ms integer, p_gave_up boolean, p_has_referer boolean,
  p_user_agent text, p_country text, p_asn text, p_as_org text, p_city text, p_region text, p_colo text,
  p_http_protocol text, p_tls_version text, p_via_worker text
) returns boolean language plpgsql set search_path = public as $$
declare
  fp text := coalesce(lower(regexp_replace(p_host, '^www\.', '')), '') || '|' || p_ip || '|' || to_char(now() at time zone 'utc', 'YYYY-MM-DD');
  created boolean;
begin
  insert into public.honeypot_maze as m (
    fingerprint, host, ip, user_agent, country, asn, as_org, city, region, colo, http_protocol, tls_version, via_worker,
    pages, distinct_pages, max_depth, held_ms, gave_up, waited_out, referer_pages, trail)
  values (
    fp, p_host, p_ip, p_user_agent, p_country, p_asn, p_as_org, p_city, p_region, p_colo, p_http_protocol, p_tls_version, p_via_worker,
    1, 1, p_depth, p_held_ms, case when p_gave_up then 1 else 0 end, case when p_gave_up then 0 else 1 end,
    case when p_has_referer then 1 else 0 end, jsonb_build_array(p_path))
  on conflict (fingerprint) do update set
    pages = m.pages + 1,
    distinct_pages = m.distinct_pages + case when jsonb_array_length(m.trail) < 100 and not m.trail @> jsonb_build_array(p_path) then 1 else 0 end,
    trail = case when jsonb_array_length(m.trail) < 100 and not m.trail @> jsonb_build_array(p_path) then m.trail || jsonb_build_array(p_path) else m.trail end,
    max_depth = greatest(m.max_depth, p_depth),
    held_ms = m.held_ms + p_held_ms,
    gave_up = m.gave_up + case when p_gave_up then 1 else 0 end,
    waited_out = m.waited_out + case when p_gave_up then 0 else 1 end,
    referer_pages = m.referer_pages + case when p_has_referer then 1 else 0 end,
    min_gap_ms = least(coalesce(m.min_gap_ms, (extract(epoch from (now() - m.last_seen)) * 1000)::integer), (extract(epoch from (now() - m.last_seen)) * 1000)::integer),
    gap_total_ms = m.gap_total_ms + (extract(epoch from (now() - m.last_seen)) * 1000)::bigint,
    user_agent = coalesce(p_user_agent, m.user_agent),
    as_org = coalesce(p_as_org, m.as_org),
    city = coalesce(p_city, m.city),
    region = coalesce(p_region, m.region),
    colo = coalesce(p_colo, m.colo),
    http_protocol = coalesce(p_http_protocol, m.http_protocol),
    tls_version = coalesce(p_tls_version, m.tls_version),
    via_worker = coalesce(p_via_worker, m.via_worker),
    last_seen = now()
  returning (xmax = 0) into created;
  return created;
end $$;
revoke all on function public.honeytar_record_maze(text, text, text, integer, integer, boolean, boolean, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.honeytar_record_maze(text, text, text, integer, integer, boolean, boolean, text, text, text, text, text, text, text, text, text, text) to service_role;
