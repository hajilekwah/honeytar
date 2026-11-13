# honeytar

**Detect, delay, ban.** A honeypot for Cloudflare Workers that tarpits scanners and sends repeat offenders to a blocklist.

- **Detect.** Fake pages at paths only scanners ask for (`/.env`, `/.git/config`, `/wp-login.php`, `/phpmyadmin` and more). Nothing on a real site links to them, so every visit is a scanner or a bot, and each one is recorded.
- **Delay.** The tarpit answers at once, then holds the page body back for 30 seconds. Most scanners have a read timeout of 5 to 30 seconds, so they give up with a timeout and the connection they tied up is wasted on a decoy. Waiting costs almost nothing on Workers (it is not CPU time).
- **Ban.** A source that probes several different decoy paths in a day is added to a Cloudflare IP list that your zones block, for 24 hours.

It also records how long each scanner was held and whether it gave up or waited it out, which tells you what kind of tool it is.

> Status: version 0.1, extracted from the author's own sites, where it has run in production. The API may change before 1.0.

## Quick start

You need a site served by a Cloudflare Worker (including Workers with static assets), and a Supabase project to store the visits. Reporting is optional: without it, honeytar still serves decoys and runs the tarpit.

### 1. Install

```sh
npm install honeytar
```

### 2. Put it in front of your Worker

```ts
import { honeytar } from 'honeytar';

export default {
  async fetch(request, env, ctx) {
    const decoy = await honeytar(request, env, ctx); // null for ordinary paths
    if (decoy) return decoy;
    return env.ASSETS.fetch(request); // or whatever your Worker normally does
  },
};
```

### 3. Configure `wrangler.jsonc`

Send only the decoy paths to the Worker, so ordinary traffic never starts it. Print the list:

```sh
node -e "import('honeytar').then(m => console.log(JSON.stringify(m.ROUTE_PATTERNS, null, 2)))"
```

```jsonc
{
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "run_worker_first": ["/wp-login.php", "/.env*", "/.git/*" /* ...the rest of the list... */]
  },
  "vars": {
    "HONEYTAR_URL": "https://YOUR-PROJECT.supabase.co/functions/v1/honeytar-ingest",
    "HONEYTAR_TARPIT_MS": "30000"
  }
}
```

Wrangler rejects a pattern that a broader one already covers. If your list already has `"/api/*"`, leave out the honeytar patterns under `/api/`.

Set the shared secret as a Worker secret, never in the file: `npx wrangler secret put HONEYTAR_SECRET`.

### 4. Set up the backend

See [docs/supabase-setup.md](docs/supabase-setup.md): run `sql/001_honeytar.sql`, deploy the `honeytar-ingest` function, and set its secret.

### 5. Try it

```sh
curl -i https://your-site.example/.env     # returns headers at once, the body after about 30 seconds
```

The visit appears in the `honeypot_hits` table within a second, and again, with how long it was held, when the connection ends.

## Settings

| Setting | Where | What it does |
|---|---|---|
| `HONEYTAR_URL` | Worker variable | The ingest endpoint. Without it nothing is reported. |
| `HONEYTAR_SECRET` | Worker secret | Shared secret the ingest function expects. At least 16 characters. |
| `HONEYTAR_TARPIT_MS` | Worker variable | Hold time in milliseconds. Unset or `0` turns the tarpit off. Capped at 120000. |

The older names `HONEYPOT_URL`, `HONEYPOT_SECRET` and `TARPIT_MS` are still accepted.

## The tarpit

- The response status and headers go out at once, so the scanner believes it is connected. The body follows after the hold.
- At most 50 connections are held per Worker instance. Beyond that, decoys answer instantly, so a flood cannot pile up open connections.
- When a scanner hangs up first, the hold ends and the slot is freed immediately.
- How each hold ended (`gave_up` after N ms, or `completed`) is reported, so you can see scanner timeouts.

## Automatic blocking

The ingest function blocks a source that asks for **four or more different decoy paths in 24 hours** (or 20 or more hits). It counts distinct paths, not raw hits, so a person who types `/.env` once while testing is not blocked. Blocks last 24 hours and are removed from Cloudflare automatically.

It never blocks private or reserved addresses, Cloudflare's own network (ASN 13335), or anything in the `ip_allowlist` table. Your zones' rule exempts Cloudflare's verified bots. Add your own connection to the allowlist first.

Setup (an account IP list and one rule per zone): [docs/cloudflare-blocklist.md](docs/cloudflare-blocklist.md). Without it, blocks are still recorded as "pending" and nothing is blocked.

## What is stored, and privacy

Per source, path and day: the address, country, network name, city and region (from Cloudflare), the user agent, a few cleaned examples of what was sent (query string, a short body sample, five selected headers), counts, and tarpit results. Cookies and other headers are never kept. Every text field is reduced to printable ASCII and capped before it is stored. Rows older than 30 days are deleted.

IP addresses are personal data in some jurisdictions. Decide whether that retention fits your situation, and say so in your privacy policy.

## Safety and responsible use

- Decoy responses are **fixed text**. Nothing from the request is ever echoed back, so decoys cannot be used to reflect content.
- Fake values use the reserved `.invalid` domain and say "decoy". No real credentials, keys or hosts appear.
- Reporting is best effort: it never throws, never delays the response, and is rate limited per Worker instance.
- Run it only on sites you own or are authorised to protect. honeytar slows and blocks scanners; it does not attack anything, and it never contacts the scanner's address.

## Development

```sh
npm install
npm test          # Vitest: decoys, tarpit, reporting, settings, ingest logic
npm run typecheck
npm run build
```

## Roadmap

- A setup script for the Cloudflare list and rules.
- Console components (a dashboard for hits, blocks and the allowlist).
- More decoy packs, for example a crypto-themed pack of fake wallet and keystore paths with obviously invalid values. Decoys only record; nothing here holds or takes anyone's funds.

## License

MIT. See [LICENSE](LICENSE).
