# AGENTS.md — honeytar

An MIT-licensed npm package (ESM, TypeScript, no runtime dependencies) that gives a Cloudflare Worker decoy pages, a tarpit, an optional crawler maze and reporting to a Supabase ingest function. Usage, settings and setup are in `README.md`; the privacy promises are in `SECURITY.md`; release history is in `CHANGELOG.md`. Read only the part the task needs.

## Commands
- Install: `npm ci` (Node 20 or newer; CI uses 22)
- Check: `npm run check` (typecheck, test and build). CI runs the same, and `npm publish` runs it first (`prepublishOnly`).
- Typecheck: `npm run typecheck` (`tsc --noEmit`)
- Test: `npm test` (Vitest)
- Build: `npm run build` (`tsc -p tsconfig.build.json` into `dist/`)

## Layout
`src/` holds the package: `index.ts` (the public surface), `handler.ts`, `decoys.ts`, `tarpit.ts`, `maze.ts`, `report.ts`, `settings.ts`. `tests/` holds the Vitest tests. `sql/` and `supabase/functions/honeytar-ingest/` are the storage side. `docs/` holds the Cloudflare blocklist and Supabase setup notes. `dist/` is build output and is not committed.

## Rules and traps
These are promises that tests check.
1. Decoys are fixed text. Never echo anything from the request into a response. Fake values use the reserved `.invalid` domain and say "decoy"; no real credentials, keys or hosts.
2. Reporting is best effort: it never throws and never delays the response, and it is rate limited per Worker instance.
3. Ingest stores clean data only. Every stored field is reduced to printable ASCII and capped (`supabase/functions/honeytar-ingest/logic.ts`).
4. Never block private or reserved addresses, Cloudflare's own network (ASN 13335) or anything in `ip_allowlist`.
5. Tarpit limits: a 120 s hold and 50 held connections per Worker instance.
6. The maze is off unless `HONEYTAR_MAZE` is set. Its pages are deterministic and `noindex`, paths are validated against the word list, and a per-instance budget of 300 pages a minute ends it with a 404. It only records; it never blocks.
7. Setting names: `HONEYTAR_*` are current. The older `HONEYPOT_URL`, `HONEYPOT_SECRET` and `TARPIT_MS` must keep working.
8. `src/index.ts` is the exported API, including `ROUTE_PATTERNS`, which consumers copy into `run_worker_first` in their `wrangler.jsonc`. Changing a pattern or an export affects every site; say so in the changelog.
9. The SQL and the function are a pair: `sql/001_honeytar.sql`, `sql/002_maze.sql` and `supabase/functions/honeytar-ingest` change together. The deployed copy lives in `personal-ops` (`supabase/functions/honeypot-ingest`) and is updated from here, not the other way round.
10. Releases: bump `version` in `package.json` and add a `CHANGELOG.md` entry. Publishing is the owner's step; do not run `npm publish`.
11. Never commit secrets (ingest secrets, Supabase keys).

## Workflow
- Run the check before pushing. Never push with a failing test.
- Add or update tests in `tests/` with every behaviour change.
- Small steps, one commit per change, clear messages.
- Say so when something could not be verified.
