// Decoy pages for paths only scanners ask for: a fake WordPress login, .env, .git/config and similar. Nothing on a
// real site links to them, so every visit is a scanner or a bot. Rules of the road:
//   - Decoy responses are fixed text. Nothing from the request is ever echoed back.
//   - Fake values use the reserved .invalid domain and say "decoy", so nothing real is ever contacted or leaked.

/**
 * Static `_headers` rules do not apply to a Worker's own responses, so decoys carry their own. The CSP allows
 * the decoy login form to post to itself and nothing else.
 */
function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('X-Frame-Options', 'DENY');
  out.headers.set('Referrer-Policy', 'no-referrer');
  return out;
}

/**
 * Paths to send to the Worker first: put these in `assets.run_worker_first` in wrangler.jsonc so ordinary traffic never
 * starts the Worker.
 * Cloudflare's path patterns are case-sensitive, so an odd-case spelling such as /WP-LOGIN.PHP never reaches
 * the Worker and gets the normal site; it still appears in the Cloudflare request logs.
 */
export const ROUTE_PATTERNS = [
  '/wp-login.php',
  '/xmlrpc.php',
  '/.env*',
  '/.git',
  '/.git/*',
  '/phpmyadmin*',
  '/phpMyAdmin*',
  '/wp-admin',
  '/wp-admin/*',
  '/wp-content/*',
  '/wp-includes/*',
  '/cgi-bin/*',
  '/.aws/*',
  // Secret-hunting sweeps ask for these too. A .env file at any depth gets the .env decoy (see decoyFor), but a
  // path pattern cannot have a wildcard in the middle, so the common folders are listed one by one.
  '/api/.env', '/v1/.env', '/v2/.env', '/public/.env', '/config/.env', '/admin/.env', '/backup/.env', '/new/.env', '/core/.env', '/frontend/.env', '/app/.env', '/laravel/.env',
  '/.docker/*', '/.github/*', '/.ssh/*', '/.gitlab-ci.yml', '/actuator', '/actuator/*', '/phpinfo.php', '/config.json', '/server-status',
] as const;

export type DecoyKind = 'wp-login' | 'wp-install' | 'wp-admin' | 'xmlrpc' | 'env' | 'git-config' | 'git-head' | 'phpmyadmin' | 'not-found';

/** Which decoy (if any) a path gets. Matching ignores case. */
export function decoyFor(pathname: string): DecoyKind | null {
  const p = pathname.toLowerCase();
  if (p === '/wp-login.php') return 'wp-login';
  if (p === '/xmlrpc.php') return 'xmlrpc';
  // A .env file in any folder (/.env, /.env.local, /api/.env, /.docker/laravel/app/.env).
  const last = p.slice(p.lastIndexOf('/') + 1);
  if (last === '.env' || last.startsWith('.env.')) return 'env';
  if (p === '/.git/config') return 'git-config';
  if (p === '/.git/head') return 'git-head';
  if (p === '/.git' || p.startsWith('/.git/')) return 'not-found';
  if (p.startsWith('/phpmyadmin')) return 'phpmyadmin';
  if (p === '/wp-admin/install.php') return 'wp-install';
  if (p === '/wp-admin' || p.startsWith('/wp-admin/')) return 'wp-admin';
  if (p === '/phpinfo.php' || p === '/config.json' || p === '/.gitlab-ci.yml' || p === '/server-status' || p === '/actuator' || p.startsWith('/actuator/')) return 'not-found';
  if (p.startsWith('/.docker/') || p.startsWith('/.github/') || p.startsWith('/.ssh/')) return 'not-found';
  if (p.startsWith('/wp-content/') || p.startsWith('/wp-includes/') || p.startsWith('/cgi-bin/') || p.startsWith('/.aws/')) return 'not-found';
  return null;
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>${title}</title></head><body>${body}</body></html>`;

const LOGIN_FORM = '<form method="post" action="/wp-login.php"><p><label>Username or Email Address <input name="log"></label></p><p><label>Password <input type="password" name="pwd"></label></p><p><button type="submit">Log In</button></p></form>';

const ENV_DECOY = [
  'APP_ENV=production',
  'APP_DEBUG=false',
  'DB_HOST=db.internal.invalid',
  'DB_PORT=3306',
  'DB_DATABASE=app',
  'DB_USERNAME=app',
  'DB_PASSWORD=decoy-not-a-real-password',
  'SECRET_KEY=decoy-not-a-real-key',
  '',
].join('\n');

const GIT_CONFIG_DECOY = [
  '[core]',
  '\trepositoryformatversion = 0',
  '\tfilemode = true',
  '\tbare = false',
  '[remote "origin"]',
  '\turl = https://git.example.invalid/decoy/site.git',
  '\tfetch = +refs/heads/*:refs/remotes/origin/*',
  '[branch "main"]',
  '\tremote = origin',
  '\tmerge = refs/heads/main',
  '',
].join('\n');

const XMLRPC_FAULT = '<?xml version="1.0" encoding="UTF-8"?><methodResponse><fault><value><struct><member><name>faultCode</name><value><int>403</int></value></member><member><name>faultString</name><value><string>Incorrect username or password.</string></value></member></struct></value></fault></methodResponse>';

const text = (body: string, status: number, type = 'text/plain; charset=utf-8') =>
  withSecurityHeaders(new Response(body, { status, headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } }));

/** The fixed response for a decoy. `method` only decides between the GET and POST variants; no request data is used. */
export function decoyResponse(kind: DecoyKind, method: string): Response {
  const posted = method === 'POST';
  switch (kind) {
    case 'wp-login':
      return text(page('Log In', posted ? `<p><strong>Error:</strong> The username or password is incorrect.</p>${LOGIN_FORM}` : LOGIN_FORM), 200, 'text/html; charset=utf-8');
    case 'wp-install':
      return text(page('Already Installed', '<h1>Already Installed</h1><p>You appear to have already installed this site.</p>'), 200, 'text/html; charset=utf-8');
    case 'wp-admin':
      return withSecurityHeaders(new Response(null, { status: 302, headers: { Location: '/wp-login.php', 'Cache-Control': 'no-store' } }));
    case 'xmlrpc':
      return posted ? text(XMLRPC_FAULT, 200, 'text/xml; charset=utf-8') : text('XML-RPC server accepts POST requests only.', 405);
    case 'env':
      return text(ENV_DECOY, 200);
    case 'git-config':
      return text(GIT_CONFIG_DECOY, 200);
    case 'git-head':
      return text('ref: refs/heads/main\n', 200);
    case 'phpmyadmin':
      return text(page('phpMyAdmin', '<h1>Welcome to phpMyAdmin</h1><form method="post"><p><label>Username <input name="pma_username"></label></p><p><label>Password <input type="password" name="pma_password"></label></p><p><button type="submit">Log in</button></p></form>'), 200, 'text/html; charset=utf-8');
    default:
      return text('Not Found', 404);
  }
}

