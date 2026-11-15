# AGENTS.md: honeytar

An MIT-licensed npm package (ESM, TypeScript, no runtime dependencies) that gives a Cloudflare Worker decoy pages, a tarpit, an optional crawler maze and reporting to a Supabase ingest function. Usage, settings and setup are in `README.md`; the privacy promises are in `SECURITY.md`; release history is in `CHANGELOG.md`.

## Commands
- `npm test`: Vitest
- `npm run typecheck`: `tsc --noEmit`
- `npm run build`: `tsc -p tsconfig.build.json` into `dist/`
- CI (`.github/workflows/ci.yml`) runs `npm ci`, typecheck, test and build. `npm publish` runs the same three first (`prepublishOnly`).

## Rules and traps (these are promises that tests check)
- **Decoys are fixed text.** Never echo anything from the request into a response. Fake values use the reserved `.invalid` domain and say "decoy"; no real credentials, keys or hosts.
- **Reporting is best effort.** It must never throw and never delay the response. It is rate limited per Worker instance.
- **Ingest stores clean data only.** Every stored field is reduced to printable ASCII and capped in length (`supabase/functions/honeytar-ingest/logic.ts`).
- **Never block** private or reserved addresses, Cloudflare's own network (ASN 13335) or anything in `ip_allowlist`.
- **Tarpit limits.** Capped at 120 s hold and 50 held connections per Worker instance.
- **Maze.** Off unless `HONEYTAR_MAZE` is set. Pages are deterministic and `noindex`, paths are validated against the word list, and a per-instance budget of 300 pages a minute ends it with a 404. It only records; it never blocks.
- **Setting names.** `HONEYTAR_*` are current. The older `HONEYPOT_URL`, `HONEYPOT_SECRET` and `TARPIT_MS` must keep working.
- **Exported API.** `src/index.ts` is the public surface, including `ROUTE_PATTERNS`, which consumers copy into `wrangler.jsonc` `run_worker_first`. Changing a pattern or export affects every site that uses the package, so say so in the changelog.
- **SQL and function are a pair.** `sql/001_honeytar.sql`, `sql/002_maze.sql` and `supabase/functions/honeytar-ingest` change together; deployed copies live in the `personal-ops` repo (`supabase/functions/honeypot-ingest`) and must be updated from here, not the other way round.
- **Releases.** Bump `version` in `package.json` and add a `CHANGELOG.md` entry. Publishing to npm is the owner's step; do not run `npm publish`.
- `dist/` is build output; do not commit it.

## Workflow
- Add or update tests in `tests/` with every behaviour change; run typecheck, test and build before saying a task is done.
