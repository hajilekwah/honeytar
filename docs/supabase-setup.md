# Backend setup (Supabase)

The Worker reports each decoy visit to a Supabase Edge Function, which stores it and decides whether to block the source.

## 1. Create the tables

Run [`sql/001_honeytar.sql`](../sql/001_honeytar.sql) in the SQL editor (or as a migration). It is safe to run again. If you will use the crawler maze, also run [`sql/002_maze.sql`](../sql/002_maze.sql).

The tables can only be read by the service role until you edit `public.honeytar_is_admin()`. The default returns `false`, so nobody can read them through the API by accident. To read them from your own dashboard, replace its body with your own check, for example `select (auth.jwt() ->> 'email') = 'you@example.com'`.

## 2. Deploy the function

```sh
supabase functions deploy honeytar-ingest --no-verify-jwt
```

`--no-verify-jwt` is required: the Worker authenticates with a shared secret, not a Supabase login. The function rejects any request without the right secret.

## 3. Set the function secrets

| Secret | Required | Value |
|---|---|---|
| `HONEYTAR_INGEST_SECRET` | yes | A long random string (at least 16 characters). The same value goes in the Worker as `HONEYTAR_SECRET`. |
| `CLOUDFLARE_API_TOKEN` | for blocking | A token with **Account → Account Filter Lists → Edit**, for your account only. |
| `CF_ACCOUNT_ID` | for blocking | Your Cloudflare account ID. |
| `CF_BLOCKLIST_ID` | for blocking | The ID of the IP list (see [cloudflare-blocklist.md](cloudflare-blocklist.md)). |

Set secrets in the Supabase dashboard (Edge Functions, Secrets) or with `supabase secrets set`. Do not paste them into chat, a repository or a shell history you share.

## 4. Point the Worker at it

In `wrangler.jsonc`: `HONEYTAR_URL` is `https://YOUR-PROJECT.supabase.co/functions/v1/honeytar-ingest`. Then `npx wrangler secret put HONEYTAR_SECRET` with the same secret as step 3.

## Notes

- Reverse DNS is looked up once per new source over DNS-over-HTTPS (`cloudflare-dns.com`), and stored. Remove `reverseName` from the function if you do not want that lookup.
- The function removes rows older than 30 days, and expired blocks, as hits arrive. There is no separate scheduler.
- The function URL is public; the secret is what protects it. Rotate the secret if it leaks, in both places.
