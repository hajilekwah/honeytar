# Blocklist setup (Cloudflare)

Blocking uses one account-level IP list and one custom rule per zone. The ingest function adds sources to the list and removes them again after 24 hours. Without this setup honeytar still works; blocks are only recorded as "pending".

Replace the `<...>` placeholders. Keep your API token in an environment variable, not on the command line.

## 1. Create the list

```sh
curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/rules/lists" \
  -H "Authorization: Bearer $CF_SETUP_TOKEN" -H "Content-Type: application/json" \
  --data '{"name":"honeypot_blocklist","kind":"ip","description":"Sources that probed the honeytar decoys; entries expire after 24h"}'
```

The response contains the list `id`: that is `CF_BLOCKLIST_ID`. Check your plan's limits on lists.

## 2. Add a rule to each zone

The rule blocks listed addresses unless they are a verified bot:

```
(ip.src in $honeypot_blocklist and not cf.client.bot)    action: block
```

In the dashboard: Security → WAF → Custom rules. Or with the API. **Look first** at what the zone already has:

```sh
curl -sS "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/rulesets/phases/http_request_firewall_custom/entrypoint" -H "Authorization: Bearer $CF_SETUP_TOKEN"
```

- If it returns a 404, the zone has no custom rules yet: `PUT` the same URL with `{"rules":[{"action":"block","expression":"(ip.src in $honeypot_blocklist and not cf.client.bot)","description":"honeytar blocklist","enabled":true}]}`.
- If it returns a ruleset, **append** with `POST https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/rulesets/<RULESET_ID>/rules` and the single rule as the body. A `PUT` would replace your existing rules.

## 3. Give the ingest function a token

Create a token with only **Account → Account Filter Lists → Edit**, for your account only, and set it (with `CF_ACCOUNT_ID` and `CF_BLOCKLIST_ID`) as function secrets. See [supabase-setup.md](supabase-setup.md).

## 4. Protect yourself first

Add your own connection to the allowlist before you rely on blocking:

```sql
insert into public.ip_allowlist (cidr, note) values ('203.0.113.0/24', 'my office');
```

IPv6 sources are blocked as their whole /64, since scanners rotate inside it; an IPv6 allowlist entry should be a /64 too.

## How blocks work

- A source is blocked after asking for four or more different decoy paths within 24 hours, or 20 hits.
- Never blocked: private and reserved addresses, Cloudflare's own network (ASN 13335), the allowlist, and verified bots (by the zone rule).
- A block lasts 24 hours. Expired blocks are removed from the list as new hits arrive, so on a very quiet day one can linger a little past its time.
- To unblock early, set the row's `expires_at` to now: the next hit removes it from the list. Or delete the item from the list in the dashboard.
