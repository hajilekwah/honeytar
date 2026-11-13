# Changelog

## 0.1.0 (unreleased)

First release as a package, extracted from the author's four live sites.

- `honeytar(request, env, ctx)`: one call that serves a decoy, reports the visit and holds the response (tarpit), or returns `null` for ordinary paths.
- Decoys for WordPress, `.env` files, `.git`, phpMyAdmin and common debug and config paths. Fixed text only; nothing from the request is ever echoed back.
- Tarpit: the decoy answers at once, then holds its body back; capped at 120 s and 50 held connections per Worker instance; frees the slot the moment the scanner hangs up.
- Reporting: each visit, and how each held connection ended (gave up or waited it out), with the connection details Cloudflare provides.
- Supabase ingest function: stores visits, blocks scanners that probe four or more different decoy paths in a day, syncs a Cloudflare IP list, expires blocks after 24 hours, looks up reverse DNS once per source.
- Never blocks private addresses, Cloudflare's own network or anything on the allowlist.
- Settings: `HONEYTAR_URL`, `HONEYTAR_SECRET`, `HONEYTAR_TARPIT_MS`. The older `HONEYPOT_URL`, `HONEYPOT_SECRET` and `TARPIT_MS` are still accepted.
