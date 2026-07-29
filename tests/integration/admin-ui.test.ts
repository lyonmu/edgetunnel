import { createExecutionContext, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { CONFIG_KEY } from '../../src/config/repository';
import { createDefaultConfig } from '../../src/config/defaults';
import { encodeBase64Url } from '../../src/security/crypto';

const origin = 'https://example.com';
const runtimeEnv: Env = {
  KV: env.KV,
  ASSETS: env.ASSETS,
  ADMIN: 'admin',
  UUID: '90cd4a77-141a-43c9-991b-08263cfe9c10',
  CONFIG_KEY: encodeBase64Url(Uint8Array.from({ length: 32 }, (_, index) => index)),
};

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`${origin}${path}`, init), runtimeEnv, createExecutionContext());
}

async function loginCookie(): Promise<string> {
  const response = await fetchWorker('/api/admin/v1/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ password: 'admin' }),
  });
  return response.headers.get('Set-Cookie')?.split(';')[0] ?? '';
}

describe('standalone admin UI', () => {
  beforeEach(async () => {
    await env.KV.put(CONFIG_KEY, JSON.stringify(createDefaultConfig()));
  });

  it('redirects unauthenticated admin visits to the login page', async () => {
    const response = await fetchWorker('/admin');

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/login');
  });

  it.each(['/login', '/admin'])('serves a local-only CSP-protected page at %s', async (path) => {
    const headers: HeadersInit = path === '/admin' ? { Cookie: await loginCookie() } : {};
    const response = await fetchWorker(path, { headers });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(html).not.toMatch(/<script[^>]+src=["']https?:/i);
    expect(html).not.toContain('localStorage');
    expect(html).not.toContain('admin-secret');
  });

  it.each([
    ['/admin/app.js', 'text/javascript'],
    ['/admin/styles.css', 'text/css'],
    ['/login/app.js', 'text/javascript'],
    ['/shared/styles.css', 'text/css'],
  ])('serves %s with its correct content type', async (path, contentType) => {
    const response = await env.ASSETS.fetch(new Request(`${origin}${path}`));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain(contentType);
  });

  it.each(['/admin/config.json', '/admin/log.json', '/admin/ADD.txt'])(
    'does not expose removed compatibility asset %s',
    async (path) => {
      const response = await fetchWorker(path, { headers: { Cookie: await loginCookie() } });
      expect(response.status).toBe(404);
    },
  );
});
