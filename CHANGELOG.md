# Changelog

## 0.2.0

- Crawler maze (opt-in): `HONEYTAR_MAZE` (URL prefix) and `HONEYTAR_MAZE_MS` (hold per page). Generated, deterministic, noindex pages that link only deeper into the maze; invalid paths are a plain 404; a per-instance budget of 300 pages a minute. Each view is reported (`kind: "maze"`) with depth, hold time and outcome.
- Ingest function: handles maze views through one atomic database function, `public.honeytar_record_maze`, and stores them in `honeypot_maze` (new `sql/002_maze.sql`). Recording only; nothing is blocked. Run the new SQL and redeploy the function to use the maze; without them, the maze setting does nothing harmful (reports are refused).
- New exports: `mazePrefix`, `mazeMs`, `mazeMatch`, `mazePage`, `mazeResponse`, `MAZE`, `WORDS`, `reportMaze`.

## 0.1.1

- Ingest function: a hold result from a scanner that gave up very quickly could be lost, because the visit's row was saved only after a reverse-DNS lookup. The row is now saved first and the hostname added afterwards, and the hold handler retries briefly if it cannot find the row yet. Redeploy the function; the npm package code is unchanged.

## 0.1.0

First release as a package, extracted from the author's four live sites.

- `honeytar(request, env, ctx)`: one call that serves a decoy, reports the visit and holds the response (tarpit), or returns `null` for ordinary paths.
- Decoys for WordPress, `.env` files, `.git`, phpMyAdmin and common debug and config paths. Fixed text only; nothing from the request is ever echoed back.
- Tarpit: the decoy answers at once, then holds its body back; capped at 120 s and 50 held connections per Worker instance; frees the slot the moment the scanner hangs up.
- Reporting: each visit, and how each held connection ended (gave up or waited it out), with the connection details Cloudflare provides.
- Supabase ingest function: stores visits, blocks scanners that probe four or more different decoy paths in a day, syncs a Cloudflare IP list, expires blocks after 24 hours, looks up reverse DNS once per source.
- Never blocks private addresses, Cloudflare's own network or anything on the allowlist.
- Settings: `HONEYTAR_URL`, `HONEYTAR_SECRET`, `HONEYTAR_TARPIT_MS`. The older `HONEYPOT_URL`, `HONEYPOT_SECRET` and `TARPIT_MS` are still accepted.
