# Security

Please report security problems privately, using GitHub's "Report a vulnerability" button on the Security tab of this repository, rather than opening a public issue.

Things this project promises, and that its tests check:

- Decoy responses are fixed text and never echo anything from the request.
- Fake values use the reserved `.invalid` domain and say "decoy".
- The Worker never throws because of reporting, and never waits for it.
- Every field the ingest function stores is reduced to printable ASCII and capped in length.
- Private addresses, Cloudflare's own network and anything on the allowlist are never blocked.
