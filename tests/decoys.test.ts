import { describe, expect, it } from 'vitest';
import { decoyFor, decoyResponse, ROUTE_PATTERNS } from '../src/decoys.js';

describe('decoyFor', () => {
  it.each([
    ['/wp-login.php', 'wp-login'], ['/WP-Login.php', 'wp-login'], ['/xmlrpc.php', 'xmlrpc'], ['/.env', 'env'], ['/.env.production', 'env'],
    ['/.git/config', 'git-config'], ['/.git/HEAD', 'git-head'], ['/.git/objects/ab', 'not-found'], ['/phpmyadmin/index.php', 'phpmyadmin'], ['/phpMyAdmin', 'phpmyadmin'],
    ['/wp-admin/install.php', 'wp-install'], ['/wp-admin/', 'wp-admin'], ['/wp-content/uploads/x.php', 'not-found'], ['/cgi-bin/test', 'not-found'], ['/.aws/credentials', 'not-found'],
    ['/api/.env', 'env'], ['/v1/.env', 'env'], ['/.docker/laravel/app/.env', 'env'], ['/.env.aws', 'env'], ['/actuator/env', 'not-found'], ['/phpinfo.php', 'not-found'],
    ['/config.json', 'not-found'], ['/.gitlab-ci.yml', 'not-found'], ['/.github/workflows/deploy.yml', 'not-found'],
  ])('%s -> %s', (path, kind) => expect(decoyFor(path)).toBe(kind));

  it.each(['/', '/blog', '/blog/a-post', '/api/health', '/sitemap.xml', '/.well-known/security.txt', '/environment', '/gitlab', '/wp', '/my.env', '/envelope', '/config', '/blog/.environment'])('leaves %s alone', (path) => expect(decoyFor(path)).toBeNull());
});

describe('decoyResponse', () => {
  it('serves fixed, harmless content with security headers, no caching and no indexing', async () => {
    const res = decoyResponse('env', 'GET');
    const body = await res.text();
    expect(body).toContain('DB_PASSWORD=decoy-not-a-real-password');
    expect(body).toContain('.invalid');
    expect(body).not.toMatch(/AKIA|BEGIN .*PRIVATE KEY|ghp_|sk_live/);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(res.headers.get('Content-Security-Policy')).toBeTruthy();
    expect(await decoyResponse('git-config', 'GET').text()).toContain('git.example.invalid');
  });
  it('shows a login form, and an error on POST, without ever echoing what was sent', async () => {
    expect(await decoyResponse('wp-login', 'GET').text()).toContain('name="pwd"');
    expect(await decoyResponse('wp-login', 'POST').text()).toContain('incorrect');
    for (const kind of ['wp-login', 'wp-install', 'xmlrpc', 'env', 'git-config', 'phpmyadmin', 'not-found'] as const) {
      expect(decoyResponse.length).toBe(2); // takes only the kind and the method: no request data
      expect(await decoyResponse(kind, 'POST').text()).not.toMatch(/<script/i);
    }
  });
  it('mimics a real server: wp-admin redirects to the login, xmlrpc GET is 405, unknown decoys are 404', () => {
    expect(decoyResponse('wp-admin', 'GET').status).toBe(302);
    expect(decoyResponse('wp-admin', 'GET').headers.get('Location')).toBe('/wp-login.php');
    expect(decoyResponse('xmlrpc', 'GET').status).toBe(405);
    expect(decoyResponse('xmlrpc', 'POST').status).toBe(200);
    expect(decoyResponse('not-found', 'GET').status).toBe(404);
  });
});

describe('ROUTE_PATTERNS', () => {
  it('has no duplicates, and every pattern is a path', () => {
    expect(new Set(ROUTE_PATTERNS).size).toBe(ROUTE_PATTERNS.length);
    for (const p of ROUTE_PATTERNS) expect(p.startsWith('/'), p).toBe(true);
  });
  it('covers the paths the decoys answer (every pattern matches at least one path that gets a decoy)', () => {
    for (const p of ROUTE_PATTERNS) {
      const base = p.replace(/\*+$/, '');
      const candidates = [base, `${base}x`, `${base}/x`, `${base}.x`, `${base}index.php`];
      expect(candidates.some((c) => decoyFor(c) !== null), p).toBe(true);
    }
  });
});
